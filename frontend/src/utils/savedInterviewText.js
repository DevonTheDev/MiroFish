import { savedInterviewExactKeys, validSavedInterviewObservation } from './savedInterviewObservation.js'
import { buildSavedInterviewQuestions } from './savedInterviewQuestions.js'

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

function textWriter() {
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
  return { append, scalar, field, warnings, finish: () => chunks.join('') }
}

function writeObservation({ append, scalar, field }, data) {
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
}

function writeSources({ append, scalar, warnings }, data) {
  append('\nRecorded sources\nCounts are recorded returned rows, not total source counts; null has_more means unknown or inapplicable, not false.\n')
  for (const [platform, name] of [['twitter', 'Twitter'], ['reddit', 'Reddit']]) {
    const source = data.sources[platform]
    append(`\nSource: ${name}\n`)
    for (const key of ['status', 'returned_count', 'has_more', 'coverage']) scalar(key, source[key])
    warnings(source.warnings)
  }
}

function writeRecords({ append, scalar, field, warnings }, rows, positions) {
  append('\nRecords in captured order\n')
  for (const [index, row] of rows.entries()) {
    append(`\nRecord ${index + 1}\n`)
    if (positions) scalar('observation_position', positions.get(row))
    scalar('platform', row.platform)
    for (const key of ['record_id', 'row_id', 'agent_id', 'timestamp']) field(key, row[key])
    for (const key of ['payload_kind', 'payload_bytes', 'truncated']) scalar(key, row[key])
    warnings(row.warnings)
    field('saved_prompt', row.prompt)
    field('saved_response', row.response)
    field('raw_preview (not decoded into a question and reply)', row.raw_preview)
  }
}

export function formatSavedInterviewText(data) {
  try {
    if (!validSavedInterviewObservation(data, { simulation_id: data?.simulation_id, filters: data?.filters })) invalid()
    const writer = textWriter(), { append } = writer
    append('Saved interview observation\n\n')
    append('Scope: all rows in this accepted observation or window, regardless of local search, selected question or page. Other windows are not included.\n')
    append('Saved prompts may include context. Records do not reconstruct conversation sessions, unique respondents, historical names, model versions or conclusions.\n')
    append('Coverage describes the recorded bounded observation. This transcript does not establish authenticity or current availability.\n')
    append('Order follows captured physical row order, not proven chronological order across sources. Repeated answers remain separate rows.\n')
    append('Encoding: fixed English labels; two-space-indented string values preserve ordinary Unicode, spaces and every LF, including empty lines. CR, tab, backslashes, other controls and lone surrogates use visible escapes.\n')
    append('Escapes present individual values; this is not a TXT import or roundtrip format. Indentation and the final LF are report formatting. JSON remains the canonical machine-readable observation.\n')
    append('Null and empty states are unindented markers. Recorded replacement characters, raw previews and truncation warnings are retained; original storage bytes cannot be recovered here.\n\n')

    writeObservation(writer, data)
    writeSources(writer, data)
    writeRecords(writer, data.records)
    return writer.finish()
  } catch { return invalid() }
}

// Captures are internal view descriptors, never an alternative file admission
// contract. Validate identity/order and question scope without rerunning search.
function capturePositions(data, capture) {
  if (!savedInterviewExactKeys(capture, ['mode', 'query', 'questionKey', 'questionPrompt', 'origin', 'filename', 'eligibleRows', 'matchingRows'])
    || !['records', 'questions'].includes(capture.mode) || typeof capture.query !== 'string'
    || !['accepted saved-storage observation', 'accepted local file'].includes(capture.origin)
    || (capture.origin === 'accepted local file' ? typeof capture.filename !== 'string' || !capture.filename : capture.filename !== null)) invalid()
  let eligible = data.records
  if (capture.mode === 'questions') {
    const groups = buildSavedInterviewQuestions(data).groups
    const group = groups.find(group => group.key === capture.questionKey)
    if (group ? capture.questionPrompt !== group.prompt : groups.length || capture.questionKey !== null || capture.questionPrompt !== null) invalid()
    eligible = group?.records ?? []
  } else if (capture.questionKey !== null || capture.questionPrompt !== null) invalid()
  if (!Array.isArray(capture.eligibleRows) || capture.eligibleRows.length !== eligible.length
    || capture.eligibleRows.some((row, index) => row !== eligible[index]) || !Array.isArray(capture.matchingRows)) invalid()
  const positions = new Map(data.records.map((row, index) => [row, index + 1]))
  const eligiblePositions = new Map(capture.eligibleRows.map((row, index) => [row, index + 1]))
  let previous = 0
  for (const row of capture.matchingRows) {
    const position = eligiblePositions.get(row)
    if (!position || position <= previous) invalid()
    previous = position
  }
  return positions
}

export function formatSavedInterviewMatchesText(data, capture) {
  try {
    if (!validSavedInterviewObservation(data, { simulation_id: data?.simulation_id, filters: data?.filters })) invalid()
    const positions = capturePositions(data, capture)
    const writer = textWriter(), { append, scalar, field } = writer
    append('Saved interview matching-row excerpt\n\n')
    append('Scope: exactly the captured matching rows in this accepted observation/window. All matching rows across all client pages are included, not total saved backend rows or other windows.\n')
    append('Missing, unreadable, limited, raw or truncated saved content may hide matches. This excerpt does not establish authenticity, current storage availability, conversation sessions or unique respondents.\n')
    append('Order follows captured physical row order, not proven chronological order across sources. Repeated answers remain separate rows.\n')
    append('Encoding: fixed English labels; two-space-indented string values preserve ordinary Unicode, spaces and every LF. CR, tab, backslashes, other controls and lone surrogates use visible escapes.\n')
    append('Null and empty states are distinct markers; raw previews, replacement characters and truncation warnings remain literal. This TXT excerpt is not an import format; full observation JSON remains canonical machine-readable evidence.\n\n')
    writeObservation(writer, data)
    append('\nCaptured view\n')
    scalar('origin', capture.origin)
    if (capture.origin === 'accepted local file') field('local_filename (unverified provenance)', capture.filename)
    field('query', capture.query)
    append('Matching: lowercase literal substring independently in saved prompt, response or raw preview; no trimming, Unicode normalization, regex, metadata matching or field concatenation. Empty query includes every eligible row.\n')
    scalar('mode', capture.mode)
    if (capture.mode === 'questions') {
      field('question_key (observation-local)', capture.questionKey, 'no complete saved question selected')
      field('question_prompt', capture.questionPrompt, 'no complete saved question selected')
      append('Question key is observation-local, not a stable question or session ID; the same key after refresh does not identify the same selection.\n')
      if (capture.questionKey === null) append('No complete saved question is selected.\n')
    }
    scalar('accepted_record_count', data.records.length)
    scalar('eligible_record_count', capture.eligibleRows.length)
    scalar('matched_record_count', capture.matchingRows.length)
    scalar('exported_record_count', capture.matchingRows.length)
    for (const [platform, name] of [['twitter', 'Twitter'], ['reddit', 'Reddit']]) {
      append(`\nExcerpt platform: ${name}\n`)
      scalar('eligible_record_count', capture.eligibleRows.filter(row => row.platform === platform).length)
      const matched = capture.matchingRows.filter(row => row.platform === platform).length
      scalar('matched_record_count', matched)
      scalar('exported_record_count', matched)
    }
    append('\nRecorded source facts for the entire accepted observation, not excerpt completeness\n')
    writeSources(writer, data)
    append('\nObservation positions are one-based client observation positions, not database totals.\n')
    if (!capture.matchingRows.length) append('No records match this captured view.\n')
    writeRecords(writer, capture.matchingRows, positions)
    // Count every escaped chunk, including metadata, indentation and final LF,
    // before assembly. Never expose a clipped or partially completed report.
    return writer.finish()
  } catch { return invalid() }
}
