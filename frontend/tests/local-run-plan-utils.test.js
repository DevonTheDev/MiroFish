import test from 'node:test'
import assert from 'node:assert/strict'
import { configuredRounds, effectiveRounds, validLocalLimits, validLocalCatalog, planningErrorKey } from '../src/utils/localRunPlan.js'
const limits = { valid: true, max_agents: 2, max_selectable_agents: 2, max_rounds: 1, max_concurrency: 1, max_catalog_entities: 1000 }
test('local rounds use finite positive configuration without floor forty or fabricated counts', () => {
  const config = { time_config: { total_simulation_hours: 1, minutes_per_round: 30 } }
  assert.equal(configuredRounds(config), 2); assert.equal(effectiveRounds(config, 1, 1), 1); assert.equal(effectiveRounds(config, 5, 10), 2)
  for (const value of [null, {}, { time_config: { total_simulation_hours: '1', minutes_per_round: 30 } }, { time_config: { total_simulation_hours: Infinity, minutes_per_round: 30 } }]) {
    assert.equal(configuredRounds(value), null); assert.equal(effectiveRounds(value, 1, 1), null)
  }
  for (const invalid of [0, -1, 1.5, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) assert.equal(effectiveRounds(config, invalid, 5), null)
})
test('local caps reject coercion, unsafe numbers, missing fields and inconsistent selection bounds', () => {
  assert.equal(validLocalLimits(limits), true)
  for (const key of Object.keys(limits).filter(key => key !== 'valid')) {
    for (const invalid of [undefined, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(validLocalLimits({ ...limits, [key]: invalid }), false)
  }
  assert.equal(validLocalLimits({ ...limits, max_selectable_agents: 1 }), false)
})
test('cast validation rejects stale simulation, duplicate IDs and malformed preview envelopes', () => {
  const entity = { uuid: 'node-a', name: 'Person A', entity_type: 'Person', summary: '', text_truncated: false }
  const data = { simulation_id: 'A', limits, eligible_count: 1, entities: [entity] }
  assert.equal(validLocalCatalog(data, 'A'), true); assert.equal(validLocalCatalog(data, 'B'), false)
  assert.equal(validLocalCatalog({ ...data, entities: [entity, entity], eligible_count: 2 }, 'A'), false)
  for (const changed of [{ uuid: '' }, { entity_type: '' }, { summary: 'x'.repeat(241) }, { text_truncated: 'false' }]) assert.equal(validLocalCatalog({ ...data, entities: [{ ...entity, ...changed }] }, 'A'), false)
})
test('public planner error copy never renders raw exceptions or unknown server codes', () => {
  assert.equal(planningErrorKey({ response: { data: { error_code: 'selection_changed', error: 'private/path' } } }), 'localPlan.changedError')
  assert.equal(planningErrorKey(new Error('secret')), 'localPlan.requestError'); assert.equal(planningErrorKey('unknown_secret_value'), 'localPlan.requestError')
})

test('catalog text bounds match backend Unicode code points for non-BMP names and summaries', () => {
  const entity = { uuid: 'node-a', name: '😀'.repeat(256), entity_type: '🧑'.repeat(128), summary: '🌍'.repeat(240), text_truncated: true }
  const data = { simulation_id: 'A', limits, eligible_count: 1, entities: [entity] }
  assert.equal(validLocalCatalog(data, 'A'), true)
  assert.equal(validLocalCatalog({ ...data, entities: [{ ...entity, name: entity.name + 'a' }] }, 'A'), false)
})
