import assert from 'node:assert/strict'
import test from 'node:test'
import { validLocalCatalog } from '../src/utils/localRunPlan.js'

import * as presets from '../src/utils/localCastPreset.js'
const required = ['acceptLocalCastPreset', 'parseLocalCastPreset', 'parseLocalCastPresetBytes', 'exportLocalCastPreset',
  'validLocalCastPresetCatalog', 'acceptCompatibleLocalCastPreset']
test('local cast preset utilities expose bounded, detached admission and compatibility APIs', () => {
  for (const name of required) assert.equal(typeof presets[name], 'function', name)
  assert.equal(presets.LOCAL_CAST_PRESET_MAX_BYTES, 256 * 1024)
})

const source = (changes = {}) => ({ schema_version: 1, kind: 'mirofish_local_cast_preset',
  project_id: 'project_A', graph_id: 'graph_A', selected_entity_ids: ['node_b', 'node_a'],
  use_llm_for_profiles: false, max_rounds: 5, ...changes })
const catalog = (changes = {}) => ({ simulation_id: 'simulation_B', project_id: 'project_A', graph_id: 'graph_A',
  total_nodes: 3, eligible_count: 3,
  entities: ['node_a', 'node_b', 'node_c'].map(uuid => ({ uuid, name: 'Same name', entity_type: 'Person', summary: '', text_truncated: false })),
  limits: { valid: true, max_agents: 10, max_selectable_agents: 10, max_rounds: 5, max_concurrency: 1, max_catalog_entities: 1000 },
  ...changes })
const rejects = (callback, code = 'invalid_preset') => assert.throws(callback, error => {
  assert.equal(error.code, code)
  assert.equal(error.message, `Invalid local cast preset: ${code}`)
  return true
})
const bytes = text => new TextEncoder().encode(text)

test('admission and export preserve ordered IDs and exactly seven fields without shared references', () => {
  const original = source(), admitted = presets.acceptLocalCastPreset(original)
  assert.deepEqual(admitted, original)
  assert.notEqual(admitted, original)
  assert.notEqual(admitted.selected_entity_ids, original.selected_entity_ids)
  original.selected_entity_ids.reverse()
  assert.deepEqual(admitted.selected_entity_ids, ['node_b', 'node_a'])
  const reordered = Object.fromEntries(Object.entries(admitted).reverse())
  assert.equal(presets.exportLocalCastPreset(reordered), presets.exportLocalCastPreset(admitted))
  assert.deepEqual(presets.parseLocalCastPreset(presets.exportLocalCastPreset(admitted)), admitted)
  assert.deepEqual(Object.keys(JSON.parse(presets.exportLocalCastPreset(admitted))), Object.keys(source()))
})

for (const [name, value] of [
  ['null', null], ['array', []], ['string', 'preset'], ['empty', {}],
  ['missing field', (() => { const value = source(); delete value.max_rounds; return value })()],
  ['symbol key', { ...source(), [Symbol('hidden')]: 1 }],
  ...['simulation_id', 'name', 'created_at', 'profiles', 'prompts', 'credentials', 'enable_reddit', 'endpoint', '__proto__']
    .map(name => [`extra ${name}`, { ...source(), [name]: 'PRIVATE SENTINEL' }]),
  ...[0, 2, '1', true, null].map(value => ['version ' + String(value), source({ schema_version: value })]),
  ...['mirofish_local_prompt_suite', '', null].map(value => ['kind ' + String(value), source({ kind: value })]),
  ...['false', 0, 1, null, [], {}].map(value => ['boolean ' + JSON.stringify(value), source({ use_llm_for_profiles: value })]),
  ...[0, -1, 1.5, '5', true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
    .map(value => ['rounds ' + String(value), source({ max_rounds: value })]),
  ...[null, {}, 'node_a', [], ['node_a', 'node_a'], ['node_a', 1], ['node_a', null], Array(1)]
    .map((value, index) => ['selection ' + index, source({ selected_entity_ids: value })]),
]) test(`schema rejects ${name}`, () => rejects(() => presets.acceptLocalCastPreset(value)))

for (const value of ['', '../private', ' spaces', 'trailing ', 'a.b', 'a/b', '汉字', 'emoji_😀', 'a\n', 'a\0', '\ud800', 'x'.repeat(129), 5, null]) {
  for (const field of ['project_id', 'graph_id', 'selected_entity_ids']) test(`portable ${field} rejects ${JSON.stringify(value)}`, () => {
    rejects(() => presets.acceptLocalCastPreset(source({ [field]: field === 'selected_entity_ids' ? [value] : value })))
  })
}

test('all 1000 maximum-length portable IDs and safe maximum rounds round trip under the byte cap', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => String(index).padStart(128, '_'))
  const original = source({ project_id: 'P'.repeat(128), graph_id: '-'.repeat(128), selected_entity_ids: ids,
    use_llm_for_profiles: true, max_rounds: Number.MAX_SAFE_INTEGER })
  const exported = presets.exportLocalCastPreset(original)
  assert.ok(bytes(exported).length < presets.LOCAL_CAST_PRESET_MAX_BYTES)
  assert.deepEqual(presets.parseLocalCastPresetBytes(bytes(exported)), original)
  rejects(() => presets.acceptLocalCastPreset(source({ selected_entity_ids: [...ids, 'one_more'] })))
})

for (const [name, raw] of [
  ['duplicate key', JSON.stringify(source()).replace('"schema_version":1', '"schema_version":1,"schema_version":1')],
  ['escaped duplicate key', JSON.stringify(source()).replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1')],
  ['unknown nested duplicates', JSON.stringify(source()).replace('{', '{"unknown":{"x":1,"\\u0078":2},')],
  ['nested array depth', '{"x":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}'],
  ['nonfinite exponent', JSON.stringify(source()).replace('"max_rounds":5', '"max_rounds":1e999')],
  ['literal NaN', JSON.stringify(source()).replace('"max_rounds":5', '"max_rounds":NaN')],
  ['lone surrogate value', JSON.stringify(source()).replace('"graph_A"', '"\\ud800"')],
  ['lone surrogate key', JSON.stringify(source()).replace('{', '{"\\udfff":1,')],
  ['literal surrogate', JSON.stringify(source()).replace('"graph_A"', '"\ud800"')],
  ['trailing content', JSON.stringify(source()) + 'true'], ['BOM', '\ufeff' + JSON.stringify(source())],
  ['comment', '/* preset */' + JSON.stringify(source())], ['trailing comma', JSON.stringify(source()).replace(/}$/, ',}')],
  ['truncated', '{'], ['empty text', ''], ['nonstring', {}],
]) test(`strict JSON rejects ${name}`, () => rejects(() => presets.parseLocalCastPreset(raw)))

test('raw text and byte admission count whitespace and actual UTF-8 bytes at exactly 256 KiB', () => {
  const raw = JSON.stringify(source()), maximum = presets.LOCAL_CAST_PRESET_MAX_BYTES
  const atLimit = raw.padEnd(maximum)
  assert.deepEqual(presets.parseLocalCastPreset(atLimit), source())
  assert.deepEqual(presets.parseLocalCastPresetBytes(bytes(atLimit).buffer), source())
  rejects(() => presets.parseLocalCastPreset(atLimit + ' '), 'file_too_large')
  rejects(() => presets.parseLocalCastPresetBytes(bytes(atLimit + ' ')), 'file_too_large')
  rejects(() => presets.parseLocalCastPreset('😀'.repeat(maximum / 4 + 1)), 'file_too_large')
  rejects(() => presets.parseLocalCastPresetBytes(new Uint8Array(maximum + 1)), 'file_too_large')
})

test('byte parser admits the exact view and rejects malformed UTF-8 without replacement', () => {
  const raw = bytes(JSON.stringify(source())), padded = new Uint8Array(raw.length + 4)
  padded.set([0xff, 0xff]); padded.set(raw, 2); padded.set([0xff, 0xff], raw.length + 2)
  assert.deepEqual(presets.parseLocalCastPresetBytes(padded.subarray(2, raw.length + 2)), source())
  for (const invalid of [[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xe2, 0x82]]) {
    rejects(() => presets.parseLocalCastPresetBytes(new Uint8Array(invalid)), 'invalid_utf8')
  }
  const bom = new Uint8Array(raw.length + 3); bom.set([0xef, 0xbb, 0xbf]); bom.set(raw, 3)
  rejects(() => presets.parseLocalCastPresetBytes(bom))
  for (const invalid of [null, 'text', [], new Uint16Array(2), {}]) rejects(() => presets.parseLocalCastPresetBytes(invalid))
})

test('preset catalog admission requires project and graph identity without changing legacy validation', () => {
  const legacy = catalog(); delete legacy.project_id; delete legacy.graph_id
  assert.equal(validLocalCatalog(legacy, 'simulation_B'), true)
  assert.equal(presets.validLocalCastPresetCatalog(legacy, 'simulation_B'), false)
  assert.equal(presets.validLocalCastPresetCatalog(catalog(), 'simulation_B'), true)
  assert.equal(presets.validLocalCastPresetCatalog(catalog(), 'simulation_other'), false)
  for (const field of ['project_id', 'graph_id']) {
    for (const value of [undefined, '../private', 'x'.repeat(129), 1]) assert.equal(presets.validLocalCastPresetCatalog(catalog({ [field]: value }), 'simulation_B'), false)
  }
  for (const changed of [null, {}, catalog({ eligible_count: 4 }), catalog({ entities: [catalog().entities[0], catalog().entities[0]] })]) {
    assert.equal(presets.validLocalCastPresetCatalog(changed, 'simulation_B'), false)
    rejects(() => presets.acceptCompatibleLocalCastPreset(source(), changed, 'simulation_B'), 'invalid_catalog')
  }
})

test('compatible presets copy exact values across simulations on the same current project and graph', () => {
  const original = source(), current = catalog()
  const admitted = presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B')
  assert.deepEqual(admitted, original)
  original.selected_entity_ids[0] = 'node_c'; current.entities[0].uuid = 'changed'
  assert.deepEqual(admitted.selected_entity_ids, ['node_b', 'node_a'])
  assert.equal(admitted.use_llm_for_profiles, false)
  assert.equal(admitted.max_rounds, 5)
  assert.deepEqual(presets.acceptCompatibleLocalCastPreset(source({ use_llm_for_profiles: true }), catalog(), 'simulation_B'), source({ use_llm_for_profiles: true }))
})

test('compatibility rejects exact identity differences, stale simulation, absent IDs and empty catalogs', () => {
  for (const field of ['project_id', 'graph_id']) {
    rejects(() => presets.acceptCompatibleLocalCastPreset(source({ [field]: 'different' }), catalog(), 'simulation_B'), 'identity_mismatch')
    rejects(() => presets.acceptCompatibleLocalCastPreset(source(), catalog({ [field]: 'different' }), 'simulation_B'), 'identity_mismatch')
  }
  rejects(() => presets.acceptCompatibleLocalCastPreset(source(), catalog(), 'simulation_A'), 'invalid_catalog')
  rejects(() => presets.acceptCompatibleLocalCastPreset(source({ selected_entity_ids: ['node_missing'] }), catalog(), 'simulation_B'), 'selection_unavailable')
  rejects(() => presets.acceptCompatibleLocalCastPreset(source(), catalog({ eligible_count: 0, entities: [] }), 'simulation_B'), 'selection_unavailable')
})

test('compatibility enforces current agent and round limits without clipping or name matching', () => {
  const current = catalog(), original = source(), before = structuredClone(original)
  assert.deepEqual(presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), original)
  current.limits.max_agents = current.limits.max_selectable_agents = 1
  rejects(() => presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), 'agent_limit_exceeded')
  current.limits.max_agents = current.limits.max_selectable_agents = 2
  current.limits.max_rounds = 4
  rejects(() => presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), 'round_limit_exceeded')
  current.limits.max_rounds = 5
  assert.deepEqual(presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), original)
  current.entities[0].uuid = 'renamed_node'
  rejects(() => presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), 'selection_unavailable')
  assert.deepEqual(original, before)
  current.limits.max_rounds = '5'
  rejects(() => presets.acceptCompatibleLocalCastPreset(original, current, 'simulation_B'), 'invalid_catalog')
})
