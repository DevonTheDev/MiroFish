import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveNodeRelationships, formatNodeRelationship, relationshipPreview } from '../src/utils/nodeRelationships.js'

const node = (uuid, name = 'Name') => ({ uuid, name })
const edge = (source_node_uuid, target_node_uuid, extra = {}) => ({ source_node_uuid, target_node_uuid, ...extra })
const derive = (id, edges, nodes = [node(id)]) => deriveNodeRelationships({ nodes, edges }, nodes[0])

test('exact raw IDs and source positions determine mutually exclusive membership', () => {
  const edges = [edge('else', 'a'), edge('a', 'a'), edge('a', 'else'),
    edge('A', 'none'), edge(' a ', 'none'), edge('other', 'other', { source_node_name: 'Name' })]
  const result = derive('a', edges)
  assert.deepEqual(result.occurrences.map(x => [x.index, x.direction]), [[0, 'incoming'], [1, 'self'], [2, 'outgoing']])
  assert.deepEqual(result.counts, { incoming: 1, self: 1, outgoing: 1 })
  for (const id of [' a ', 'not-a-uuid', '__proto__', 'constructor', 'é', 'e\u0301']) {
    const result = derive(id, [edge(id, 'opposite'), edge(id.normalize('NFD') + 'x', 'none')])
    assert.equal(result.occurrences.length, 1)
    assert.equal(result.id, id)
  }
  assert.equal(derive('é', [edge('e\u0301', 'none')]).occurrences.length, 0)
})

test('invalid selected ID classes are distinct from zero and unavailable arrays', () => {
  for (const id of [undefined, null, '', ' \t\n', 0, 1, false, true, [], {}, new String('a')]) {
    assert.equal(derive(id, []).state, 'invalid')
  }
  assert.equal(derive('a', []).state, 'ready')
  for (const graph of [{}, { nodes: {}, edges: [] }, { nodes: [], edges: null }, { nodes: [], edges: 'a' }]) {
    assert.deepEqual(deriveNodeRelationships(graph, node('a')), { state: 'unavailable' })
  }
})

test('sparse/skipped entries, repeated raw references and missing edge IDs preserve occurrence positions', () => {
  const shared = edge('a', 'missing', { uuid: 'duplicate' })
  const edges = [null, shared, undefined, 4, [], shared, { ...shared }, edge(undefined, 'a'), edge('a', {}), edge('a', 'a')]
  delete edges[2]
  const result = derive('a', edges)
  assert.deepEqual(result.occurrences.map(x => x.index), [1, 5, 6, 7, 8, 9])
  assert.equal(result.occurrences[0].raw, result.occurrences[1].raw)
  assert.deepEqual(result.counts, { outgoing: 4, incoming: 1, self: 1 })
})

test('endpoint names require exactly one matching node position and use a safe literal-ID map', () => {
  const shared = node('a', 'Must not pick')
  const nodes = [shared, shared, node('b', 'B1'), node('b', 'B2'), node('__proto__', 'Literal prototype')]
  const result = derive('a', [edge('a', 'b', { source_node_name: 'Producer A', target_node_name: 'Producer B' }),
    edge('a', '__proto__'), edge('a', 'gone'), edge('a', null)], nodes)
  assert.equal(result.duplicateCount, 2)
  const rows = result.occurrences.map(x => formatNodeRelationship(result, x))
  assert.deepEqual([rows[0].source.text, rows[0].source.count, rows[0].target.text, rows[0].target.count], ['Producer A', 2, 'Producer B', 2])
  assert.equal(rows[0].source.status, 'multiple')
  assert.equal(rows[1].target.text, 'Literal prototype')
  assert.equal(rows[2].target.status, 'notLoaded')
  assert.equal(rows[3].target.status, 'idUnavailable')
})

test('preview limits preserve literal UTF-16 boundaries without conversion hooks or split pairs', () => {
  for (const length of [80, 96, 160]) {
    assert.equal(relationshipPreview('x'.repeat(length), length), 'x'.repeat(length))
    assert.equal(relationshipPreview('x'.repeat(length + 1), length), 'x'.repeat(length) + '…')
    assert.equal(relationshipPreview('x'.repeat(length - 1) + '😀tail', length), 'x'.repeat(length - 1) + '…')
  }
  const hostile = { toString() { throw new Error('must not convert') } }
  const result = derive('a', [edge('a', hostile, { name: hostile, fact_type: [], fact: hostile, uuid: hostile })])
  const row = formatNodeRelationship(result, result.occurrences[0])
  assert.equal(row.label, 'RELATED_TO'); assert.equal(row.recordedType, 'Unknown')
  assert.equal(row.fact, ''); assert.equal(row.uuid, ''); assert.equal(row.target.text, '')
  assert.equal(relationshipPreview('  literal \n ', 80), '  literal \n ')
})

test('derivation does not read facts; formatting reads only the requested occurrences', () => {
  let reads = 0
  const records = Array.from({ length: 45 }, () => ({ ...edge('a', 'b'), get fact() { reads++; return 'full fact' } }))
  const result = derive('a', records)
  assert.equal(reads, 0)
  result.occurrences.slice(20, 40).map(x => formatNodeRelationship(result, x))
  assert.equal(reads, 20)
})
