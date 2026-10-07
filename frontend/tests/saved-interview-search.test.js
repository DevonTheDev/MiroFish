import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { record, observation } from './helpers/saved-interviews-view-fixture.js'
import { validSavedInterviewObservation } from '../src/utils/savedInterviewObservation.js'

const utilityUrl = new URL('../src/utils/savedInterviewSearch.js', import.meta.url)
const utility = existsSync(utilityUrl) ? await import(utilityUrl) : {}
function search(records, query) {
  assert.equal(typeof utility.filterSavedInterviewRecords, 'function', 'saved-interview text search must be implemented')
  return utility.filterSavedInterviewRecords(records, query)
}
function assertRows(actual, expected) {
  assert.equal(actual.length, expected.length)
  expected.forEach((row, index) => assert.equal(actual[index], row))
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

// Regex matching, trimming, field joining, case folding beyond toLowerCase,
// metadata search, deduplication or cloning rows must change these results.
test('matches a case-insensitive substring in each saved text field independently', () => {
  const rows = [
    record('twitter', '4', { prompt: 'Before NeEdLe after', response: 'other' }),
    record('twitter', '3', { prompt: 'other', response: 'Before NEEDLE after' }),
    record('twitter', '2', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '{"text":"needle"', warnings: ['invalid_json'] }),
    record('twitter', '1', { prompt: 'other', response: 'other' }),
  ]
  assertRows(search(rows, 'nEeDlE'), rows.slice(0, 3))
  assertRows(search(rows, 'before needle'), rows.slice(0, 2))
  assertRows(search(rows, 'absent'), [])
})

for (const query of ['.', '.*', '[a-z]+', '(', ')', '^', '$', '?', '*', '+', '{2}', '|', '\\', '<img src=x onerror=alert(1)>']) {
  test(`treats ${JSON.stringify(query)} as a literal substring`, () => {
    const match = record('twitter', '2', { prompt: `prefix ${query} suffix`, response: '' })
    const other = record('twitter', '1', { prompt: 'plain TEXT', response: 'another response' })
    assertRows(search([other, match], query), [match])
  })
}

test('retains spaces, tabs and newlines in queries without trimming or collapsing them', () => {
  const rows = [
    record('twitter', '5', { prompt: ' A  B\tC\nD ', response: '' }),
    record('twitter', '4', { prompt: 'A B C D', response: '' }),
    record('twitter', '3', { prompt: 'ABCD', response: '' }),
    record('twitter', '2', { prompt: '', response: '' }),
    record('twitter', '1', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
  ]
  assertRows(search(rows, ' '), rows.slice(0, 2))
  assertRows(search(rows, '  '), [rows[0]])
  assertRows(search(rows, ' a  b\tc\nd '), [rows[0]])
  assertRows(search(rows, '\t'), [rows[0]])
  assertRows(search(rows, '\n'), [rows[0]])
  assertRows(search(rows, 'a b'), [rows[1]])
})

test('does not assemble a match across prompt and response or across records', () => {
  const rows = [
    record('twitter', '2', { prompt: 'over', response: 'lap' }),
    record('twitter', '1', { prompt: 'two', response: 'words' }),
  ]
  for (const query of ['overlap', 'over lap', 'two words', 'laptwo', 'lap two']) {
    assertRows(search(rows, query), [])
  }
  assertRows(search(rows, 'over'), [rows[0]])
  assertRows(search(rows, 'WORDS'), [rows[1]])
})

test('does not search IDs, timestamps, platform, payload metadata or warnings', () => {
  const rows = [
    record('twitter', '9223372036854775807', { prompt: 'visible', response: 'content', agent_id: '9007199254740993' }),
    record('reddit', '1', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'visible content', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated', 'invalid_json'] }),
  ]
  for (const query of ['twitter', 'reddit', '9223372036854775807', 'twitter:9223372036854775807', '9007199254740993', '2026-10-06', 'structured', 'raw', '17000', 'true', 'payload_truncated', 'invalid_json', 'null', 'undefined']) {
    assertRows(search(rows, query), [])
  }
})

test('uses ordinary lowercase mapping without Unicode normalization or broader case folding', () => {
  const rows = [
    record('twitter', '6', { prompt: 'CAFÉ', response: '' }),
    record('twitter', '5', { prompt: 'Cafe\u0301', response: '' }),
    record('twitter', '4', { prompt: 'Straße', response: '' }),
    record('twitter', '3', { prompt: 'İSTANBUL', response: '' }),
    record('twitter', '2', { prompt: 'ＡＢＣ', response: '' }),
    record('twitter', '1', { prompt: 'ΟΣ', response: '' }),
  ]
  assertRows(search(rows, 'café'), [rows[0]])
  assertRows(search(rows, 'cafe\u0301'), [rows[1]])
  assertRows(search(rows, 'STRASSE'), [])
  assertRows(search(rows, 'STRAẞE'), [rows[2]])
  assertRows(search(rows, 'i\u0307s'), [rows[3]])
  assertRows(search(rows, 'istanbul'), [])
  assertRows(search(rows, 'abc'), [])
  assertRows(search(rows, 'ａｂｃ'), [rows[4]])
  assertRows(search(rows, 'ος'), [rows[5]])
  assertRows(search(rows, 'Σ'), [])
})

test('preserves literal Unicode, emoji and lone-surrogate substring semantics', () => {
  const rows = [
    record('twitter', '4', { prompt: '界😀尾', response: '' }),
    record('twitter', '3', { prompt: 'A\ud800B', response: '' }),
    record('twitter', '2', { prompt: 'C\udc00D', response: '' }),
    record('twitter', '1', { prompt: '\ufffd', response: '' }),
  ]
  assertRows(search(rows, '界😀'), [rows[0]])
  assertRows(search(rows, '\ud83d'), [rows[0]])
  assertRows(search(rows, '\ud800b'), [rows[1]])
  assertRows(search(rows, '\udc00'), [rows[2]])
  assertRows(search(rows, '\ufffd'), [rows[3]])
})

test('searches accepted raw and truncated previews and available fields of incomplete records', () => {
  const rows = [
    record('twitter', '6', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'needle raw', warnings: ['invalid_json'] }),
    record('twitter', '5', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'needle cut', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '4', { prompt: 'needle prompt', response: null, warnings: ['missing_response'] }),
    record('twitter', '3', { prompt: null, response: 'needle response', warnings: ['missing_prompt'] }),
    record('twitter', '2', { prompt: 'needle structured preview', response: '', truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '1', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
  ]
  const data = freeze(observation({ records: rows }))
  assert.equal(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), true)
  const original = JSON.stringify(data)
  assertRows(search(data.records, 'NEEDLE'), rows.slice(0, 5))
  assertRows(search(data.records, 'missing_payload'), [])
  assert.equal(JSON.stringify(data), original)
  rows.forEach(row => assert.ok(Object.isFrozen(row.warnings)))
})

test('empty query returns every row, including missing payloads, in a new mutable array', () => {
  const rows = freeze([
    record('twitter', '3', { prompt: '', response: '' }),
    record('twitter', '2', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '', warnings: ['invalid_json'] }),
    record('twitter', '1', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
  ])
  const result = search(rows, '')
  assert.notEqual(result, rows)
  assertRows(result, rows)
  result.pop()
  assert.equal(rows.length, 3)
  const empty = freeze([])
  for (const query of ['', 'needle']) {
    const filtered = search(empty, query)
    assert.notEqual(filtered, empty)
    assert.deepEqual(filtered, [])
  }
})

test('preserves row identity, repeated agents and text, source order and frozen content', () => {
  const rows = freeze([
    record('twitter', '4', { prompt: 'needle', response: 'repeat' }),
    record('twitter', '3', { prompt: 'other', response: '' }),
    record('twitter', '2', { prompt: 'needle', response: 'repeat' }),
    record('reddit', '1', { prompt: 'needle', response: 'repeat' }),
  ])
  const original = JSON.stringify(rows)
  const result = search(rows, 'NEEDLE')
  assert.notEqual(result, rows)
  assertRows(result, [rows[0], rows[2], rows[3]])
  result.reverse()
  assert.equal(JSON.stringify(rows), original)
  assertRows(search(rows, 'needle'), [rows[0], rows[2], rows[3]])
})

test('searches the last accepted row and the end of an accepted maximum-length field', () => {
  const prompt = 'x'.repeat(16384 - 6) + 'Needle'
  const rows = ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, index) => record(platform, String(100 - index), { prompt: platform === 'reddit' && index === 99 ? prompt : 'other', response: '' })))
  const data = freeze(observation({ records: rows }))
  assert.equal(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), true)
  assertRows(search(data.records, 'NEEDLE'), [rows[199]])
  assertRows(search(data.records, ''), rows)
})

for (const [label, query] of [['undefined', undefined], ['null', null], ['number', 0], ['boolean', false], ['bigint', 1n], ['symbol', Symbol('needle')], ['array', ['needle']], ['object', {}], ['boxed string', new String('needle')], ['function', () => 'needle']]) {
  test(`rejects a ${label} query rather than coercing it`, () => {
    for (const rows of [[], [record()]]) assert.throws(() => search(rows, query), TypeError)
  })
}

test('rejects a query object without invoking conversion hooks or its lowercase method', () => {
  let calls = 0
  const convert = () => { calls++; throw new Error('query must not be coerced') }
  const query = { toString: convert, valueOf: convert, toLowerCase: convert, [Symbol.toPrimitive]: convert }
  assert.throws(() => search(freeze([record()]), query), TypeError)
  assert.equal(calls, 0)
})
