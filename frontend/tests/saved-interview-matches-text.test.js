import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import * as text from '../src/utils/savedInterviewText.js'
import { validSavedInterviewObservation } from '../src/utils/savedInterviewObservation.js'
import { buildSavedInterviewQuestions } from '../src/utils/savedInterviewQuestions.js'
import { filterSavedInterviewRecords } from '../src/utils/savedInterviewSearch.js'
import { readSavedInterviewFile } from '../src/utils/savedInterviewFiles.js'
import { observation, windowObservation, record, source } from './helpers/saved-interviews-view-fixture.js'

function capture(data, query = '', questionKey = null, overrides = {}) {
  const group = buildSavedInterviewQuestions(data).groups.find(group => group.key === questionKey)
  const eligibleRows = questionKey === null ? [...data.records] : [...group?.records ?? []]
  return { mode: questionKey === null ? 'records' : 'questions', query,
    questionKey, questionPrompt: group?.prompt ?? null,
    origin: 'accepted saved-storage observation', filename: null,
    eligibleRows, matchingRows: filterSavedInterviewRecords(eligibleRows, query), ...overrides }
}
function format(data, view = capture(data)) {
  assert.ok(validSavedInterviewObservation(data, { simulation_id: data.simulation_id, filters: data.filters }), 'valid original observation required')
  return text.formatSavedInterviewMatchesText(data, view)
}
const block = (label, value) => `${label}:\n  ${value}\n`
const positions = output => [...output.matchAll(/^observation_position: (\d+)$/gm)].map(match => Number(match[1]))

test('baseline witness: matching TXT has a distinct formatter and explicit excerpt heading', () => {
  assert.equal(typeof text.formatSavedInterviewMatchesText, 'function')
  assert.ok(format(observation()).startsWith('Saved interview matching-row excerpt\n'))
})

test('ordered all-page matching subsequence preserves original positions, repeated rows and full source facts', () => {
  const data = observation({ records: ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 32 }, (_, i) => record(platform, String(20 - i), { prompt: 'Repeated', response: i % 3 ? 'MATCH' : 'excluded' }))) })
  const before = JSON.stringify(data), view = capture(data, 'mAtCh'), output = format(data, view)
  assert.ok(view.matchingRows.length > 25)
  assert.deepEqual(positions(output), data.records.flatMap((row, i) => row.response === 'MATCH' ? [i + 1] : []))
  assert.equal(output.match(/^Record \d+$/gm).length, 42)
  for (const value of ['accepted_record_count: 64', 'eligible_record_count: 64', 'matched_record_count: 42', 'exported_record_count: 42', block('query', 'mAtCh'), 'mode: records', 'Window metadata: not recorded (version 1)', 'Recorded source facts for the entire accepted observation, not excerpt completeness', 'All matching rows across all client pages', 'not total saved backend rows']) assert.ok(output.includes(value), value)
  for (const platform of ['Twitter', 'Reddit']) {
    assert.ok(output.includes(`Source: ${platform}\nstatus: available\nreturned_count: 32\nhas_more: false\ncoverage: complete`))
    assert.ok(output.includes(`Excerpt platform: ${platform}\neligible_record_count: 32\nmatched_record_count: 21\nexported_record_count: 21`))
  }
  assert.doesNotMatch(output, /^Saved interview observation$/m)
  assert.doesNotMatch(output, /  excluded\n/)
  assert.equal(JSON.stringify(data), before)
})

test('selected complete and empty prompts retain exact local question descriptors and unfiltered group counts', () => {
  const data = observation({ records: [record('twitter', '5', { prompt: ' Exact\nquestion ', response: 'yes' }), record('twitter', '4', { prompt: ' Exact\nquestion ', response: 'no' }), record('twitter', '3', { prompt: '', response: 'yes' }), record('reddit', '0', { prompt: ' Exact\nquestion ', response: 'YES' })] })
  const output = format(data, capture(data, 'yes', 'question-0'))
  assert.deepEqual(positions(output), [1, 4])
  for (const value of ['mode: questions', block('question_key (observation-local)', 'question-0'), block('question_prompt', ' Exact\n  question '), 'eligible_record_count: 3', 'matched_record_count: 2', 'not a stable question or session ID']) assert.ok(output.includes(value), value)
  const empty = format(data, capture(data, '', 'question-1'))
  assert.deepEqual(positions(empty), [3])
  assert.ok(empty.includes('query:\n[empty saved string]\n'))
  assert.ok(empty.includes('question_prompt:\n[empty saved string]\n'))
  assert.doesNotMatch(empty, /No complete saved question is selected/)
})

test('empty, whitespace and zero-match queries preserve the existing literal matching semantics', () => {
  const data = observation({ records: [record('twitter', '3', { prompt: 'left', response: 'right' }), record('twitter', '2', { prompt: 'é', response: 'two  spaces' }), record('twitter', '1', { prompt: 'lower', response: 'UPPER [.*]' })] })
  for (const [query, expected] of [['', [1, 2, 3]], ['  ', [2]], ['UpPeR [.*]', [3]], ['left right', []], ['e\u0301', []], ['twitter', []]]) {
    const output = format(data, capture(data, query))
    assert.deepEqual(positions(output), expected, query)
    assert.equal(output.includes('No records match this captured view'), expected.length === 0)
    assert.ok(output.includes(`exported_record_count: ${expected.length}\n`))
  }
  // The formatter validates capture descriptors, not a second query algorithm.
  assert.deepEqual(positions(format(data, capture(data, 'captured association', null, { matchingRows: [data.records[2]] }))), [3])
})

test('no complete question produces an explicit empty excerpt distinct from an empty-string prompt', () => {
  const data = observation({ records: [record('twitter', '1', { prompt: null, response: null, raw_preview: '{raw}', payload_kind: 'raw', warnings: ['invalid_json'] })] })
  const output = format(data, capture(data, '', null, { mode: 'questions', eligibleRows: [], matchingRows: [] }))
  assert.ok(output.includes('No complete saved question is selected'))
  assert.ok(output.includes('No records match this captured view'))
  assert.ok(output.includes('question_prompt:\n[null; no complete saved question selected]'))
  assert.ok(output.includes('accepted_record_count: 1\neligible_record_count: 0\nmatched_record_count: 0\nexported_record_count: 0'))
})

test('v2 newest and older windows retain accepted filters, revision, limits and excluded source facts', () => {
  for (const before of [null, '-7']) {
    const data = windowObservation({ filters: { platform: 'reddit', agent_id: '7' }, window: { before_row: before, source_revision: 'b'.repeat(64) }, records: [record('reddit', '-9223372036854775808', { agent_id: '7' })] })
    const output = format(data)
    for (const value of ['version: 2', block('platform_filter', 'reddit'), block('agent_id_filter', '7'), block('source_revision', 'b'.repeat(64)), 'rows_total: 200', 'response_bytes_per_platform: 4186112', 'Source: Twitter\nstatus: not_requested\nreturned_count: 0\nhas_more: null\ncoverage: not_requested']) assert.ok(output.includes(value), value)
    assert.ok(output.includes(before === null ? 'before_row:\n[null; newest captured window]' : block('before_row', before)))
    assert.doesNotMatch(output, /Window metadata: not recorded/)
  }
})

test('missing, unreadable, limited and unknown sources remain original facts even with zero matches', () => {
  for (const [status, warning] of [['missing', 'source_missing'], ['unreadable', 'source_unreadable'], ['query_limited', 'query_limited'], ['too_large', 'database_too_large']]) {
    const data = observation({ records: [], sources: { twitter: source({ status, has_more: null, coverage: 'unavailable', warnings: [warning] }), reddit: source({ status: 'missing', has_more: null, coverage: 'unavailable', warnings: ['source_missing'] }) } })
    const output = format(data, capture(data, 'not present'))
    assert.ok(output.includes(`status: ${status}\nreturned_count: 0\nhas_more: null\ncoverage: unavailable\nwarnings:\n  ${warning}`))
    assert.ok(output.includes('null has_more means unknown or inapplicable, not false'))
    assert.ok(output.includes('availability: unavailable'))
  }
  const data = observation({ records: [record('twitter')], sources: { twitter: source({ returned_count: 1, has_more: true, coverage: 'partial', warnings: ['response_limit'] }), reddit: source() } })
  assert.ok(format(data, capture(data, 'absent')).includes('returned_count: 1\nhas_more: true\ncoverage: partial\nwarnings:\n  response_limit'))
})

test('hostile captured metadata and records use the same literal field escaping without clipping or mutation', async () => {
  const value = '<script>中文 🚀 e\u0301</script>\nRecord 999\r\t\\\0\u202e\ud800\n '
  const data = observation({ observed_at: value, records: [record('twitter', '5', { prompt: value, response: '' }), record('twitter', '4', { prompt: null, response: null, raw_preview: 'raw\ufffd\r\n<reply>', payload_kind: 'raw', payload_bytes: 99999, truncated: true, warnings: ['invalid_utf8', 'payload_truncated'] }), record('twitter', '3', { prompt: null, response: null, raw_preview: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }), record('twitter', '2', { prompt: '', response: null, warnings: ['missing_response'] }), record('twitter', '1', { truncated: true, warnings: ['timestamp_truncated'] })] })
  const saved = await readSavedInterviewFile(new File([JSON.stringify(data)], 'saved.json'))
  const before = JSON.stringify(saved), view = capture(saved, value, null, { origin: 'accepted local file', filename: value, matchingRows: [...saved.records] })
  Object.freeze(view.eligibleRows); Object.freeze(view.matchingRows); Object.freeze(view)
  const output = format(saved, view)
  for (const label of ['query', 'local_filename (unverified provenance)', 'observed_at', 'saved_prompt']) assert.ok(output.includes(block(label, '<script>中文 🚀 e\u0301</script>\n  Record 999\\r\\t\\\\\\u0000\\u202e\\ud800\n   ')), label)
  assert.doesNotMatch(output, /^Record 999$/m)
  assert.doesNotMatch(output, /[\r\t\0\u202e\ud800]/u)
  assert.ok(output.includes('saved_response:\n[empty saved string]'))
  assert.ok(output.includes('saved_response:\n[null; unavailable or inapplicable]'))
  assert.ok(output.includes('payload_kind: missing\npayload_bytes: null'))
  assert.ok(output.includes('payload_kind: raw\npayload_bytes: 99999\ntruncated: true'))
  assert.ok(output.includes('raw_preview (not decoded into a question and reply):\n  raw\ufffd\\r\n  <reply>'))
  assert.equal(await new Blob([output]).text(), output)
  assert.equal(JSON.stringify(saved), before)
})

test('rejects invalid observations and inconsistent, duplicate, reordered or foreign capture rows', () => {
  const data = observation(), view = capture(data), [a, b] = data.records
  const invalid = [null, {}, { ...view, query: null }, { ...view, mode: 'other' }, { ...view, origin: 'invented' }, { ...view, filename: 'live.json' }, { ...view, origin: 'accepted local file' }, { ...view, exported_record_count: 99 }, { ...view, matchingRows: [a, a] }, { ...view, matchingRows: [b, a] }, { ...view, matchingRows: [{ ...a }] }, { ...view, eligibleRows: [a] }, { ...view, eligibleRows: [b, a] }, { ...view, eligibleRows: [a, a] }, { ...view, eligibleRows: [] }, { ...view, mode: 'questions', questionKey: 'question-9', questionPrompt: a.prompt }, { ...view, mode: 'questions', questionKey: 'question-0', questionPrompt: 'different' }, { ...view, mode: 'questions', questionKey: null, questionPrompt: null, eligibleRows: [], matchingRows: [] }, { ...view, questionKey: 'question-0' }]
  for (const item of invalid) assert.throws(() => text.formatSavedInterviewMatchesText(data, item), /Saved interview text could not be formatted/)
  for (const bad of [null, {}, { ...data, sources: { ...data.sources, twitter: { ...data.sources.twitter, returned_count: 0 } } }]) assert.throws(() => text.formatSavedInterviewMatchesText(bad, view), /Saved interview text could not be formatted/)
})

for (const unit of ['x', '\0', '\n']) test(`escaped UTF-8 cap accepts exactly 8 MiB and rejects one byte more using query unit ${JSON.stringify(unit)}`, () => {
  assert.equal(text.SAVED_INTERVIEW_TEXT_MAX_BYTES, 8 * 1024 * 1024)
  const data = observation(), view = capture(data, 'x', null, { matchingRows: [] })
  const base = new TextEncoder().encode(format(data, view)).byteLength
  const width = unit === '\0' ? 6 : unit === '\n' ? 3 : 1
  const extra = text.SAVED_INTERVIEW_TEXT_MAX_BYTES - base
  const query = 'x' + unit.repeat(Math.floor(extra / width)) + 'x'.repeat(extra % width)
  const output = format(data, { ...view, query })
  assert.equal(new TextEncoder().encode(output).byteLength, text.SAVED_INTERVIEW_TEXT_MAX_BYTES)
  assert.ok(output.endsWith('\n'))
  assert.throws(() => text.formatSavedInterviewMatchesText(data, { ...view, query: query + 'x' }), /Saved interview text could not be formatted/)
})
