import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { formatSavedInterviewText, SAVED_INTERVIEW_TEXT_MAX_BYTES } from '../src/utils/savedInterviewText.js'
import { validSavedInterviewObservation } from '../src/utils/savedInterviewObservation.js'
import { readSavedInterviewFile } from '../src/utils/savedInterviewFiles.js'
import { observation, windowObservation, record, source } from './helpers/saved-interviews-view-fixture.js'

const format = data => {
  assert.ok(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), 'fixture must satisfy existing admission')
  return formatSavedInterviewText(data)
}
const field = (label, value) => `${label}:\n  ${value}\n`

test('deterministic complete v1 text preserves limits, literal metadata, signed IDs and captured order', () => {
  const rows = [record('twitter', '9223372036854775807', { agent_id: '9223372036854775807', timestamp: '1900 misleading', prompt: 'Repeated', response: 'Same reply' }), record('twitter', '-9223372036854775808', { timestamp: '2999 misleading', prompt: 'Repeated', response: 'Same reply' }), record('reddit', '9')]
  const data = observation({ records: rows, observed_at: ' literal\r\nnot a parsed date ' })
  const text = format(data)
  assert.equal(formatSavedInterviewText(data), text)
  assert.ok(text.startsWith('Saved interview observation\n'))
  assert.ok(text.endsWith('\n'))
  for (const literal of ['version: 1\n', field('simulation_id', 'sim_A'), field('observed_at', ' literal\\r\n  not a parsed date '), 'platform_filter:\n[null; no platform filter]', 'agent_id_filter:\n[null; no exact-agent filter]', 'availability: complete', 'record_count: 3', 'order: platform_then_row_desc', 'Window metadata: not recorded (version 1)']) assert.ok(text.includes(literal), literal)
  const limitKeys = ['rows_per_platform', 'rows_total', 'database_bytes', 'wal_bytes', 'vm_operations_per_platform', 'lock_timeout_seconds', 'payload_bytes', 'timestamp_bytes', 'response_bytes', 'response_bytes_per_platform']
  let last = text.indexOf('Recorded limits\n')
  for (const key of limitKeys) { const position = text.indexOf(`${key}: ${data.limits[key]}\n`); assert.ok(position > last, key); last = position }
  assert.ok(text.indexOf('Source: Twitter') < text.indexOf('Source: Reddit'))
  assert.ok(text.includes('status: available\nreturned_count: 2\nhas_more: false\ncoverage: complete\nwarnings:\n[none recorded]'))
  for (const [index, row] of rows.entries()) {
    const block = text.split(`Record ${index + 1}\n`)[1].split(/\nRecord \d+\n/)[0]
    for (const literal of [`platform: ${row.platform}`, field('record_id', row.record_id), field('row_id', row.row_id), field('agent_id', row.agent_id), field('timestamp', row.timestamp), 'payload_kind: structured', 'payload_bytes: 80', 'truncated: false', field('saved_prompt', row.prompt), field('saved_response', row.response), 'raw_preview (not decoded into a question and reply):\n[null; unavailable or inapplicable]']) assert.ok(block.includes(literal), literal)
  }
  assert.equal(text.match(/  Same reply\n/g).length, 2)
  assert.match(text, /physical row order, not proven chronological order/)
  assert.match(text, /do not reconstruct conversation sessions, unique respondents, historical names, model versions or conclusions/)
  assert.match(text, /does not establish authenticity or current availability/)
})

test('v2 newest and signed older windows retain exact provenance and excluded source facts', () => {
  for (const before of [null, '-7']) {
    const data = windowObservation({ filters: { platform: 'reddit', agent_id: '9223372036854775807' }, records: [record('reddit', '-9223372036854775808', { agent_id: '9223372036854775807' })], window: { before_row: before, source_revision: 'e'.repeat(64) } })
    const text = format(data)
    assert.ok(text.includes(before === null ? 'before_row:\n[null; newest captured window]' : field('before_row', '-7')))
    assert.ok(text.includes(field('source_revision', 'e'.repeat(64))))
    assert.ok(text.includes(field('platform_filter', 'reddit')))
    assert.ok(text.includes(field('agent_id_filter', '9223372036854775807')))
    assert.ok(text.includes('Source: Twitter\nstatus: not_requested\nreturned_count: 0\nhas_more: null\ncoverage: not_requested'))
    assert.doesNotMatch(text, /Window metadata: not recorded/)
  }
})

test('missing, empty, raw, undecoded, replaced and truncated observations remain distinct', () => {
  const rows = [
    record('twitter', '8', { prompt: null, response: '', warnings: ['missing_prompt'] }),
    record('twitter', '7', { prompt: '', response: null, warnings: ['missing_response'] }),
    record('twitter', '6', { prompt: null, response: null, raw_preview: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
    record('twitter', '5', { prompt: null, response: null, raw_preview: '', payload_kind: 'raw', warnings: ['invalid_json'] }),
    record('twitter', '4', { prompt: null, response: null, raw_preview: '{broken\ufffd', payload_kind: 'raw', warnings: ['invalid_utf8', 'invalid_json'] }),
    record('twitter', '3', { timestamp: 'partial timestamp', truncated: true, warnings: ['timestamp_truncated'] }),
    record('twitter', '2', { prompt: null, response: null, raw_preview: 'prefix', payload_kind: 'raw', payload_bytes: 99999, truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '1', { agent_id: null, timestamp: null, warnings: ['invalid_agent_id', 'missing_timestamp'] }),
  ]
  const text = format(observation({ records: rows }))
  assert.ok(text.includes('saved_prompt:\n[null; unavailable or inapplicable]\nsaved_response:\n[empty saved string]'))
  assert.ok(text.includes('saved_prompt:\n[empty saved string]\nsaved_response:\n[null; unavailable or inapplicable]'))
  assert.ok(text.includes('payload_kind: missing\npayload_bytes: null'))
  assert.ok(text.includes('raw_preview (not decoded into a question and reply):\n[empty saved string]'))
  assert.ok(text.includes('warnings:\n  invalid_utf8\n  invalid_json\n'))
  assert.ok(text.includes(field('raw_preview (not decoded into a question and reply)', '{broken\ufffd')))
  assert.ok(text.includes('payload_bytes: 99999\ntruncated: true'))
  assert.ok(text.includes('warnings:\n  timestamp_truncated\n'))
  assert.ok(text.includes('agent_id:\n[null; unavailable or inapplicable]\ntimestamp:\n[null; unavailable or inapplicable]'))
})

test('healthy empty, unavailable, partial and unknown-more source facts are never turned into totals', () => {
  const healthy = format(observation({ records: [] }))
  assert.ok(healthy.includes('availability: complete\nrecord_count: 0'))
  assert.equal(healthy.match(/returned_count: 0\nhas_more: false\ncoverage: complete/g).length, 2)
  for (const [status, code] of [['missing', 'source_missing'], ['unreadable', 'source_unreadable'], ['too_large', 'database_too_large'], ['query_limited', 'query_limited']]) {
    const text = format(observation({ records: [], sources: { twitter: source({ status, has_more: null, coverage: 'unavailable', warnings: [code] }), reddit: source() } }))
    assert.ok(text.includes(`status: ${status}\nreturned_count: 0\nhas_more: null\ncoverage: unavailable\nwarnings:\n  ${code}`))
    assert.ok(text.includes('availability: partial'))
  }
  const text = format(observation({ records: [record()], sources: { twitter: source({ returned_count: 1, has_more: true, coverage: 'partial', warnings: ['response_limit'] }), reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }) } }))
  assert.ok(text.includes('returned_count: 1\nhas_more: true\ncoverage: partial'))
  assert.match(text, /null has_more means unknown or inapplicable, not false/)
  assert.match(text, /recorded returned rows, not total source counts/)
  const unavailable = format(observation({ records: [], sources: { twitter: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }), reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }) } }))
  assert.ok(unavailable.includes('availability: unavailable'))
})

test('individual value blocks preserve every LF and space while making controls and literal backslashes visible', () => {
  const value = ' \n\nRecord 99\n[null; unavailable or inapplicable]\r\n\r\t\\\0\x01\x1f\x7f\x85\u200b\u202e\u2066\u2028\u2029\u{e0001}\n '
  const expected = ' \n  \n  Record 99\n  [null; unavailable or inapplicable]\\r\n  \\r\\t\\\\\\u0000\\u0001\\u001f\\u007f\\u0085\\u200b\\u202e\\u2066\\u2028\\u2029\\udb40\\udc01\n   '
  const text = format(observation({ observed_at: value.slice(0, 50), records: [record('twitter', '1', { timestamp: value, prompt: value, response: 'tail\n\n' })] }))
  assert.ok(text.includes(field('saved_prompt', expected)))
  assert.ok(text.includes(field('timestamp', expected)))
  assert.ok(text.includes('saved_response:\n  tail\n  \n  \n'))
  assert.doesNotMatch(text, /[\r\t\x00-\x09\x0b-\x1f\x7f-\x9f\u200b\u202e\u2066\u2028\u2029]/)
  assert.equal(text.match(/^Record 99$/gm), null)
  assert.match(text, /individual values; this is not a TXT import or roundtrip format/)
})

test('ordinary Unicode, literal markup and escape-looking strings stay distinct from lone surrogates', async () => {
  const value = '中文 e\u0301 \ud83d\ude80 <script>alert(1)</script> =SUM(A1)\n\ud800|\udfff|\\ud800|\\u202e'
  const text = format(observation({ records: [record('twitter', '1', { prompt: value })] }))
  assert.ok(text.includes('  中文 e\u0301 🚀 <script>alert(1)</script> =SUM(A1)\n  \\ud800|\\udfff|\\\\ud800|\\\\u202e'))
  assert.doesNotMatch(text, /\ufffd/)
  assert.equal(await new Blob([text]).text(), text)
})

test('uses the existing admission contract, rejects invalid inputs and never mutates a frozen accepted file', async () => {
  const data = observation({ records: [record('twitter', '1', { prompt: '\ud800\n  literal  ' })] })
  const frozen = await readSavedInterviewFile(new File([JSON.stringify(data)], 'saved.json'))
  assert.ok(Object.isFrozen(frozen.records[0]))
  const before = JSON.stringify(frozen)
  assert.equal(format(frozen), format(data))
  assert.equal(JSON.stringify(frozen), before)
  for (const input of [null, {}, { ...data, version: 3 }, { ...data, extra: 'not admitted' }, { ...data, simulation_id: 'CON' }, { ...data, records: [data.records[0], data.records[0]] }, { ...data, observed_at: '' }, { ...data, limits: { ...data.limits, rows_total: 201 } }]) assert.throws(() => formatSavedInterviewText(input), /Saved interview text could not be formatted/)
})

test('exports every row of large valid newline/control-heavy data within the fixed UTF-8 cap and rejects oversized input', () => {
  assert.equal(SAVED_INTERVIEW_TEXT_MAX_BYTES, 8 * 1024 * 1024)
  const rows = ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, i) => record(platform, String(100-i), { prompt: '\n'.repeat(6500), response: '\0\t\\\r\u202e'.repeat(100) })))
  const data = observation({ records: rows })
  const text = format(data)
  assert.equal(text.match(/^Record \d+$/gm).length, 200)
  assert.equal(text.match(/  \\u0000\\t\\\\\\r\\u202e/g).length, 200)
  const bytes = new TextEncoder().encode(text).byteLength
  assert.ok(bytes > 4 * 1024 * 1024, 'exercise multi-megabyte escaped output')
  assert.ok(bytes <= SAVED_INTERVIEW_TEXT_MAX_BYTES)
  const oversized = observation({ records: rows.map(row => ({ ...row, prompt: '\n'.repeat(16384), response: '\0'.repeat(16384) })) })
  assert.equal(validSavedInterviewObservation(oversized, { simulation_id: oversized.simulation_id, filters: oversized.filters }), false)
  assert.throws(() => formatSavedInterviewText(oversized), /Saved interview text could not be formatted/)
})
