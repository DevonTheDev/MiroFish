import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readSavedInterviewFile } from '../src/utils/savedInterviewFiles.js'
import { buildSavedInterviewQuestions } from '../src/utils/savedInterviewQuestions.js'
import { record, observation } from './helpers/saved-interviews-view-fixture.js'

const utilityUrl = new URL('../src/utils/savedInterviewComparison.js', import.meta.url)
const empty = () => ({ records: [], counts: { twitter: 0, reddit: 0 } })
// Baseline's actual single-observation projection makes the missing behavior
// observable, rather than treating an import failure as a behavioral red.
const compare = existsSync(utilityUrl) ? (await import(utilityUrl)).buildSavedInterviewComparison : (left) => {
  const index = left ? buildSavedInterviewQuestions(left) : { groups: [], ungroupedRecords: [] }
  return { groups: index.groups.map(group => ({ key: group.key, prompt: group.prompt, left: { records: group.records, counts: group.counts }, right: empty() })), ungroupedRecords: { left: index.ungroupedRecords, right: [] } }
}
const admit = data => readSavedInterviewFile(new File([JSON.stringify(data)], 'observation.json'))
const rows = (prompts, platform = 'twitter') => prompts.map((prompt, index) => record(platform, String(prompts.length - index), { prompt }))

test('joins exact complete prompts in left-first union order, never matching local question keys', async () => {
  const prompts = ['Question?', 'question?', 'Question? ', ' Question?', 'Interview: Question?', 'é?', 'e\u0301?', '', '__proto__', 'constructor', '<script>literal</script>\u0000\ud800']
  const left = await admit(observation({ records: rows(prompts) }))
  const right = await admit(observation({ records: rows([prompts[9], 'right only', ...prompts.slice().reverse()]) }))
  const before = JSON.stringify([left, right]), actual = compare(left, right)
  assert.deepEqual(actual.groups.map(group => group.prompt), [...prompts, 'right only'])
  assert.equal(new Set(actual.groups.map(group => group.key)).size, actual.groups.length)
  assert.deepEqual(actual.groups[0].left.records, [left.records[0]])
  assert.deepEqual(actual.groups[0].right.records, [right.records.at(-1)])
  assert.deepEqual(actual.groups[9].right.records, [right.records[0], right.records[3]])
  assert.deepEqual(actual.groups.at(-1).left, empty())
  assert.equal(actual.groups.at(-1).right.records[0], right.records[1])
  assert.equal(JSON.stringify([left, right]), before)
})

test('retains repeated agents, identical side record IDs, every reply beyond page 25 and decimal identities', async () => {
  const leftRows = Array.from({ length: 27 }, (_, index) => record('twitter', String(31 - index), { agent_id: '9007199254740993', response: index === 0 ? null : index === 1 ? '' : `left ${index}`, warnings: index === 0 ? ['missing_response'] : [] }))
  leftRows[0].agent_id = '9223372036854775807'
  const rightRows = Array.from({ length: 31 }, (_, index) => record('twitter', String(31 - index), { response: `right ${index}` }))
  rightRows.push(record('reddit', '-9223372036854775808'))
  const left = await admit(observation({ records: leftRows })), right = await admit(observation({ records: rightRows }))
  const group = compare(left, right).groups[0]
  assert.deepEqual(group.left.counts, { twitter: 27, reddit: 0 })
  assert.deepEqual(group.right.counts, { twitter: 31, reddit: 1 })
  assert.equal(group.left.records.length, 27); assert.equal(group.right.records.length, 32)
  group.left.records.forEach((row, index) => assert.equal(row, left.records[index]))
  group.right.records.forEach((row, index) => assert.equal(row, right.records[index]))
  assert.equal(group.left.records[0].record_id, group.right.records[0].record_id)
  assert.equal(group.left.records[0].response, null); assert.equal(group.left.records[1].response, '')
  assert.equal(group.right.records.at(-1).row_id, '-9223372036854775808')
})

test('keeps missing/raw/payload previews ungrouped on each side while empty and timestamp-only prompts align', async () => {
  const data = observation({ records: [
    record('twitter', '6', { prompt: '' }),
    record('twitter', '5', { prompt: 'Complete', truncated: true, warnings: ['timestamp_truncated'] }),
    record('twitter', '4', { prompt: null, warnings: ['missing_prompt'] }),
    record('twitter', '3', { prompt: null, response: null, payload_kind: 'raw', raw_preview: 'partial', payload_bytes: 17000, truncated: true, warnings: ['payload_truncated'] }),
    record('twitter', '2', { prompt: null, response: null, payload_kind: 'missing', payload_bytes: null, warnings: ['missing_payload'] }),
    record('twitter', '1', { prompt: 'Incomplete', truncated: true, warnings: ['payload_truncated'] }),
  ] })
  const left = await admit(data), right = await admit(data), actual = compare(left, right)
  assert.deepEqual(actual.groups.map(group => group.prompt), ['', 'Complete'])
  assert.deepEqual(actual.ungroupedRecords.left, left.records.slice(2))
  assert.deepEqual(actual.ungroupedRecords.right, right.records.slice(2))
  assert.equal(actual.groups[1].right.records[0], right.records[1])
})

test('bounds a fully admitted two-observation union to 400 groups without mutating either side', async () => {
  const make = side => observation({ records: ['twitter', 'reddit'].flatMap(platform => Array.from({ length: 100 }, (_, index) => record(platform, String(100 - index), { prompt: `${side} ${platform} ${index}` }))) })
  const left = await admit(make('left')), right = await admit(make('right')), actual = compare(left, right)
  assert.equal(actual.groups.length, 400)
  assert.equal(actual.groups[199].left.records[0], left.records[199])
  assert.equal(actual.groups[200].right.records[0], right.records[0])
  assert.equal(actual.groups[399].right.records[0], right.records[199])
  assert.equal(Object.isFrozen(left.records), true); assert.equal(Object.isFrozen(right.records[199]), true)
})

test('supports either empty side and preserves zero observed records without inventing source completeness', async () => {
  const full = await admit(observation()), blank = await admit(observation({ records: [] }))
  assert.equal(compare(null, full).groups[0].right.records.length, 2)
  assert.equal(compare(blank, full).groups[0].left.records.length, 0)
  assert.deepEqual(compare(null, null), { groups: [], ungroupedRecords: { left: [], right: [] } })
  assert.deepEqual(compare(blank, blank), { groups: [], ungroupedRecords: { left: [], right: [] } })
})
