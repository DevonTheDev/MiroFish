import assert from 'node:assert/strict'
import test from 'node:test'
import { focusSavedActivity } from '../src/utils/savedActivityReview.js'
import { readSavedActivityFile } from '../src/utils/savedActivityFiles.js'
import { syntheticActivityPage, file } from './helpers/saved-activity-files-view-fixture.js'

const platforms = ['twitter', 'reddit', 'twitter', 'reddit', 'twitter', 'reddit', 'reddit', 'twitter']
const outcomes = [true, false, null, true, false, null, false, null]
async function admittedPage() {
  const value = syntheticActivityPage(), original = value.actions[0]
  value.offset = 100; value.limit = value.returned_count = 8; value.matched_count = 275
  value.actions = platforms.map((platform, i) => ({ ...original, record_id: `legacy:${i + 1}`, platform, success: outcomes[i], details_json: '{"id":9007199254740993,"success":true}' }))
  return readSavedActivityFile(file(value))
}
const expected = {
  all: { all: [1, 2, 3, 4, 5, 6, 7, 8], success: [1, 4], failed: [2, 5, 7], unknown: [3, 6, 8] },
  twitter: { all: [1, 3, 5, 8], success: [1], failed: [5], unknown: [3, 8] },
  reddit: { all: [2, 4, 6, 7], success: [4], failed: [2, 7], unknown: [6] },
}
for (const [platform, filters] of Object.entries(expected)) for (const [outcome, numbers] of Object.entries(filters)) test(`${platform}/${outcome} projects original frozen rows without changing historical metadata`, async () => {
  const page = await admittedPage(), original = JSON.stringify(page)
  assert.ok(Object.isFrozen(page)); assert.ok(Object.isFrozen(page.actions)); page.actions.forEach(row => assert.ok(Object.isFrozen(row)))
  const result = focusSavedActivity(page.actions, platform, outcome)
  assert.deepEqual(result.map(row => row.record_id), numbers.map(number => `legacy:${number}`))
  result.forEach((row, index) => assert.equal(row, page.actions[numbers[index] - 1], 'keep the exact admitted row object'))
  assert.equal(JSON.stringify(page), original)
})

test('default review preserves all original rows, including repeated attempts', async () => {
  const page = await admittedPage(), result = focusSavedActivity(page.actions)
  assert.deepEqual(result, page.actions)
  result.forEach((row, index) => assert.equal(row, page.actions[index]))
  assert.equal(result[1].details_json, result[6].details_json)
  assert.notEqual(result[1], result[6])
})

test('outcome matching is strict and never derives execution success from details', () => {
  const rows = Object.freeze([true, false, null, 0, '', 'false', undefined].map((success, index) => Object.freeze({ platform: 'twitter', success, details_json: '{"success":true}', index })))
  for (const [outcome, index] of [['success', 0], ['failed', 1], ['unknown', 2]]) {
    const result = focusSavedActivity(rows, 'twitter', outcome)
    assert.equal(result.length, 1); assert.equal(result[0], rows[index])
  }
})

test('platform matching uses exact recorded values without normalization', () => {
  const rows = Object.freeze(['twitter', 'reddit', 'Twitter', ' twitter'].map(platform => Object.freeze({ platform, success: null })))
  assert.deepEqual(focusSavedActivity(rows, 'twitter', 'unknown'), [rows[0]])
  assert.deepEqual(focusSavedActivity(rows, 'reddit', 'unknown'), [rows[1]])
})

test('empty input and a local zero retain the original frozen input', async () => {
  const rows = Object.freeze([])
  assert.deepEqual(focusSavedActivity(rows, 'reddit', 'failed'), [])
  const page = await admittedPage(), original = JSON.stringify(page)
  assert.deepEqual(focusSavedActivity(Object.freeze([page.actions[0]]), 'reddit', 'failed'), [])
  assert.equal(JSON.stringify(page), original)
})
