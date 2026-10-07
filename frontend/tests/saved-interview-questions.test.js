import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { record, observation } from './helpers/saved-interviews-view-fixture.js'

const utilityUrl = new URL('../src/utils/savedInterviewQuestions.js', import.meta.url)
const utility = existsSync(utilityUrl) ? await import(utilityUrl) : {}
function group(data) {
  assert.equal(typeof utility.buildSavedInterviewQuestions, 'function', 'saved-question grouping must be implemented')
  return utility.buildSavedInterviewQuestions(data)
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

// Coalescing near matches, dropping repeated agents, or paging before grouping
// must change these assertions against the actual pure projection.
test('groups only exact stored strings in first-seen order without normalizing context, case, whitespace or Unicode', () => {
  const prompts = ['Question?', 'question?', 'Question? ', ' Question?', 'Interview: Question?', 'é?', 'e\u0301?', '__proto__', 'constructor', '']
  const rows = prompts.map((prompt, i) => record('twitter', String(30 - i), { prompt }))
  rows.push(record('reddit', '5', { prompt: prompts[0] }), record('reddit', '4', { prompt: '' }))
  const { groups, ungroupedRecords } = group(observation({ records: rows }))
  assert.deepEqual(groups.map(g => g.prompt), prompts)
  assert.equal(new Set(groups.map(g => g.key)).size, prompts.length)
  assert.ok(groups.every(g => typeof g.key === 'string' && !g.key.includes(g.prompt || '__empty__')))
  assert.deepEqual(groups[0].records, [rows[0], rows[10]])
  assert.deepEqual(groups[0].counts, { twitter: 1, reddit: 1 })
  assert.deepEqual(groups.at(-1).records, [rows[9], rows[11]])
  assert.deepEqual(ungroupedRecords, [])
})

test('retains repeated records, missing replies, exact decimal IDs and members beyond the first page without mutating frozen input', () => {
  const rows = [record('twitter', '9223372036854775807', { agent_id: '9223372036854775807', response: null, warnings: ['missing_response'] }), ...Array.from({ length: 28 }, (_, i) => record('twitter', String(28 - i), { agent_id: '9007199254740993' })), record('twitter', '-9223372036854775808', { response: '' }), record('reddit', '1')]
  const data = freeze(observation({ records: rows })), serialized = JSON.stringify(data)
  const { groups } = group(data)
  assert.equal(groups.length, 1); assert.equal(groups[0].records.length, 31)
  assert.deepEqual(groups[0].counts, { twitter: 30, reddit: 1 })
  groups[0].records.forEach((row, index) => assert.equal(row, rows[index]))
  assert.equal(groups[0].records[0].agent_id, '9223372036854775807')
  assert.equal(groups[0].records[1].agent_id, '9007199254740993')
  assert.equal(groups[0].records[29].row_id, '-9223372036854775808')
  assert.equal(groups[0].records[0].response, null); assert.equal(groups[0].records[29].response, '')
  assert.equal(JSON.stringify(data), serialized)
})

test('empty prompts group while missing, raw and payload-truncated prompts remain ungrouped; timestamp-only truncation is complete', () => {
  const rows = [
    record('twitter', '7', { prompt: '' }),
    record('twitter', '6', { prompt: null, warnings: ['missing_prompt'] }),
    record('twitter', '5', { prompt: null, response: null, payload_kind: 'raw', raw_preview: '{"prompt":"partial', warnings: ['invalid_json'] }),
    record('twitter', '4', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
    record('twitter', '3', { prompt: 'Incomplete structured claim', truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '2', { prompt: 'Complete', truncated: true, warnings: ['timestamp_truncated'] }),
    record('twitter', '1', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'partial', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated'] }),
  ]
  const { groups, ungroupedRecords } = group(freeze(observation({ records: rows })))
  assert.deepEqual(groups.map(g => g.prompt), ['', 'Complete'])
  assert.deepEqual(ungroupedRecords, [rows[1], rows[2], rows[3], rows[4], rows[6]])
})

test('derives at most the accepted 200 groups and preserves full hostile-looking prompts literally', () => {
  const prompt = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n' + '界😀 '.repeat(1500)
  const rows = ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, i) => record(platform, String(100 - i), { prompt: i === 0 && platform === 'twitter' ? prompt : `${platform} ${i}` })))
  const { groups } = group(freeze(observation({ records: rows })))
  assert.equal(groups.length, 200); assert.equal(groups[0].prompt, prompt)
  assert.equal(groups[199].records[0], rows[199]); assert.equal(groups[0].records[0].prompt, prompt)
})

test('empty accepted observation has no groups or ungrouped records', () => {
  assert.deepEqual(group(observation({ records: [] })), { groups: [], ungroupedRecords: [] })
})
